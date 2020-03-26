import * as Yup from 'yup';
import { startOfHour, parseISO, isBefore, format, subHours } from 'date-fns';
import pt from 'date-fns/locale/pt';

import Appointment from '../models/appointment';
import User from '../models/user';
import File from '../models/file';

import Notification from '../schemas/notification';
import Queue from '../../lib/queue';
import CancellationMail from '../jobs/cancellationMail';

class AppointmentController {
  async index(req, res) {
    const { page = 1 } = req.query;
    const allAppointments = await Appointment.findAll({
      where: { user_id: req.userId, canceled_at: null },
      order: ['date'],
      attributes: ['id', 'date', 'past', 'cancelable'],
      limit: 20,
      offset: (page - 1) * 20,
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['id', 'name'],
          include: [
            {
              model: File,
              as: 'avatar',
              attributes: ['id', 'path', 'url'],
            },
          ],
        },
      ],
    });
    return res.json(allAppointments);
  }

  async store(req, res) {
    const schema = Yup.object().shape({
      provider_id: Yup.number().required(),
      date: Yup.date().required(),
    });
    if (!(await schema.isValid(req.body))) {
      return res.status(400).json({ error: 'Dados incorretos' });
    }

    const { provider_id, date } = req.body;

    const isProvider = User.findOne({
      where: { id: provider_id, provider: true },
    });
    if (!isProvider) {
      return res.status(401).json({ error: 'Prestador não encontrado!' });
    }

    const hourStart = startOfHour(parseISO(date));
    if (isBefore(hourStart, new Date())) {
      return res
        .status(401)
        .json({ error: 'Favor informar uma data atual ou futura' });
    }

    const checkAppointment = await Appointment.findOne({
      where: { provider_id, canceled_at: null, date: hourStart },
    });
    if (checkAppointment) {
      return res.status(400).json({ error: 'Agendamento não disponível' });
    }

    const user = await User.findByPk(req.userId);
    if (user.id === provider_id) {
      return res
        .status(401)
        .json({ error: 'Favor selecione um prestador válido!' });
    }
    /**
     * Notificações para o prestador do serviço
     */
    const dateFormated = format(hourStart, "'dia' dd 'de' MMMM', às' H:mm'h'", {
      locale: pt,
    });
    await Notification.create({
      content: `Novo agendamento de ${user.name} para ${dateFormated}`,
      user: provider_id,
    });

    const appointment = await Appointment.create({
      user_id: req.userId,
      provider_id,
      date: hourStart,
    });

    return res.json(appointment);
  }

  async delete(req, res) {
    const appointment = await Appointment.findByPk(req.params.id, {
      include: [
        {
          model: User,
          as: 'provider',
          attributes: ['name', 'email'],
        },
        {
          model: User,
          as: 'user',
          attributes: ['name'],
        },
      ],
    });

    if (appointment.user_id !== req.userId) {
      res.status(401).json({
        error: 'Você não tem permissão para cancelar este agendamento',
      });
    }

    const dateSub = subHours(appointment.date, 2);

    if (isBefore(dateSub, new Date())) {
      return res.status(401).json({ error: 'Horário de cancelamento expirou' });
    }

    appointment.canceled_at = new Date();
    await appointment.save();

    Queue.add(CancellationMail.key, {
      appointment,
    });

    return res.json(appointment);
  }
}
export default new AppointmentController();
